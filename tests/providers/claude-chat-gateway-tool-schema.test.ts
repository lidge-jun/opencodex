import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";

const unionRoot = {
  oneOf: [
    { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  ],
};

const gateway: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://gateway.example.test/v1",
  apiKey: "test-key",
  authMode: "key",
};

function toolFor(modelId: string, provider: OcxProviderConfig = gateway, wireModelOverride?: string, parameters: Record<string, unknown> = unionRoot) {
  const parsed: OcxParsedRequest = {
    modelId,
    ...(wireModelOverride ? { _wireModelOverride: wireModelOverride } : {}),
    context: {
      messages: [{ role: "user", content: "Use the tool", timestamp: 0 }],
      tools: [{ name: "automation_update", namespace: "mcp__codex_app", description: "Update an automation", parameters, strict: true }],
    },
    stream: false,
    options: {},
  };
  const body = JSON.parse(createOpenAIChatAdapter(provider).buildRequest(parsed).body) as {
    tools: Array<{ function: Record<string, unknown> }>;
  };
  return body.tools[0].function;
}

describe("Claude behind a Chat Completions gateway: tool schema root", () => {
  test.each(["oneOf", "anyOf"])("flattens a %s root without promoting branch required fields", composition => {
    const fn = toolFor("claude-sonnet-5-5", gateway, undefined, { [composition]: unionRoot.oneOf });
    const parameters = fn.parameters as Record<string, unknown>;
    expect(parameters.type).toBe("object");
    expect(parameters.required).toBeUndefined();
    expect(parameters.properties).toMatchObject({ id: { type: "string" }, name: { type: "string" } });
    for (const key of ["oneOf", "anyOf", "allOf"]) expect(parameters[key]).toBeUndefined();
  });

  test("allOf merges root and branch required fields and preserves root metadata", () => {
    const schema = {
      title: "Lookup", additionalProperties: false,
      properties: { existing: { type: "boolean" } }, required: ["existing"],
      allOf: unionRoot.oneOf,
    };
    expect(toolFor("claude-sonnet-5-5", gateway, undefined, schema).parameters).toEqual({
      title: "Lookup", additionalProperties: false, type: "object",
      properties: { existing: { type: "boolean" }, id: { type: "string" }, name: { type: "string" } },
      required: ["existing", "id", "name"],
    });
  });

  test.each([false, true])("preserves nested schemas, literals and caller input (root union: %s)", rootUnion => {
    const properties = {
      value: { type: ["string", "number"] },
      nullable: { type: ["string", "null"] },
      nested: { anyOf: [{ type: "string" }, { type: "number" }] },
      payload: {
        type: "object",
        default: { encrypted: true, type: ["string", "number"], required: [] },
        examples: [{ encrypted: true, type: ["string", "null"] }],
      },
    };
    const schema = rootUnion
      ? { anyOf: [{ type: "object", properties }] }
      : { type: "object", properties };
    const before = structuredClone(schema);
    const fn = toolFor("claude-sonnet-5-5", gateway, undefined, schema);
    expect(fn.parameters).toEqual({ type: "object", properties });
    expect(fn.strict).toBe(true);
    expect(schema).toEqual(before);
  });

  test("a non-Claude wire override excludes a Claude request alias", () => {
    const fn = toolFor("claude-alias", gateway, "gpt-5.6-terra");
    expect(fn.parameters).toEqual({ ...unionRoot, type: "object" });
    expect(fn.strict).toBe(true);
  });

  test("recognises provider-prefixed and upper-case Claude ids", () => {
    for (const id of ["anthropic/claude-opus-5", "Claude-Opus-5-5"]) {
      const parameters = toolFor(id).parameters as Record<string, unknown>;
      expect(parameters.oneOf).toBeUndefined();
      expect(parameters.type).toBe("object");
    }
  });

  test("uses the wire model id when the request is rewritten", () => {
    const parameters = toolFor("alias-model", gateway, "claude-opus-5").parameters as Record<string, unknown>;
    expect(parameters.oneOf).toBeUndefined();
  });

  test("leaves non-Claude models on the same gateway unchanged", () => {
    for (const id of ["gpt-5.6-terra", "kimi-k3", "glm-5.3", "claude"]) {
      const fn = toolFor(id);
      expect(fn.parameters).toEqual({ ...unionRoot, type: "object" });
      expect(fn.strict).toBe(true);
    }
  });
});
