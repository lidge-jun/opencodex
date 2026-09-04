import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";

const toolSchema = {
  oneOf: [
    { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  ],
  enum: ["invalid-at-root"],
  const: "invalid-at-root",
  not: { type: "null" },
};

function requestFor(provider: OcxProviderConfig): Record<string, unknown> {
  const parsed: OcxParsedRequest = {
    modelId: "model-router",
    context: {
      messages: [{ role: "user", content: "Use the tool", timestamp: 0 }],
      tools: [{ name: "automation_update", namespace: "mcp__codex_app", description: "Update an automation", parameters: toolSchema, strict: true }],
    },
    stream: false,
    options: {},
  };
  return JSON.parse(createOpenAIChatAdapter(provider).buildRequest(parsed).body) as Record<string, unknown>;
}

describe("Azure Model Router tool schemas", () => {
  test("flattens forbidden root composition and removes strict", () => {
    const body = requestFor({
      adapter: "openai-chat",
      baseUrl: "https://example.openai.azure.com/openai/v1",
      apiKey: "test-key",
      authMode: "key",
    });
    const fn = ((body.tools as Array<{ function: Record<string, unknown> }>)[0]).function;
    const parameters = fn.parameters as Record<string, unknown>;

    expect(parameters.type).toBe("object");
    expect(parameters.properties).toMatchObject({ id: { type: "string" }, name: { type: "string" } });
    for (const key of ["oneOf", "anyOf", "allOf", "enum", "const", "not"]) expect(parameters[key]).toBeUndefined();
    expect(fn.strict).toBeUndefined();
  });

  test("leaves non-Azure OpenAI-compatible tool schemas unchanged", () => {
    const body = requestFor({ adapter: "openai-chat", baseUrl: "https://api.example.test/v1", apiKey: "test-key", authMode: "key" });
    const fn = ((body.tools as Array<{ function: Record<string, unknown> }>)[0]).function;
    expect(fn.parameters).toEqual({ ...toolSchema, type: "object" });
    expect(fn.strict).toBe(true);
  });
});
