import { describe, expect, test } from "bun:test";
import { createCommandCodeAdapter } from "../../src/adapters/command-code";
import { normalizeAnthropicInputSchema } from "../../src/adapters/anthropic-input-schema";
import type { OcxParsedRequest, OcxProviderConfig, OcxTool } from "../../src/types";

const provider: OcxProviderConfig = {
  adapter: "command-code",
  baseUrl: "https://api.commandcode.ai",
  authMode: "oauth",
  apiKey: "secret-command-key",
};

function parsedRequest(tools: OcxTool[]): OcxParsedRequest {
  return {
    modelId: "anthropic/claude-sonnet-4.5",
    stream: true,
    options: {},
    context: {
      messages: [{ role: "user", content: "run the tool", timestamp: 0 }],
      tools,
    },
  };
}

/** The schemas Command Code actually sends: buildRequest -> params.tools[].input_schema. */
async function wiredSchemas(tools: OcxTool[]): Promise<Record<string, Record<string, unknown>>> {
  const request = await createCommandCodeAdapter(provider).buildRequest(parsedRequest(tools));
  const body = JSON.parse(request.body) as {
    params: { tools: Array<{ name: string; input_schema: Record<string, unknown> }> };
  };
  return Object.fromEntries(body.params.tools.map(tool => [tool.name, tool.input_schema]));
}

describe("Command Code wireTools input_schema", () => {
  test("normalizes root oneOf, anyOf, and allOf in the outbound request", async () => {
    const schemas = await wiredSchemas([
      {
        name: "choice",
        description: "choice",
        parameters: {
          oneOf: [
            { type: "object", properties: { read: { type: "string" } }, required: ["read"] },
            { type: "object", properties: { write: { type: "string" } }, required: ["write"] },
          ],
        },
      },
      {
        name: "either",
        description: "either",
        parameters: {
          anyOf: [
            { type: "object", properties: { a: { type: "number" } } },
            { type: "object", properties: { b: { type: "number" } } },
          ],
        },
      },
      {
        name: "all",
        description: "all",
        parameters: {
          allOf: [
            { type: "object", properties: { limit: { type: "integer" } }, required: ["limit"] },
            { type: "object", properties: { sort: { type: "string" } }, required: ["sort"] },
          ],
        },
      },
    ] as OcxTool[]);

    expect(schemas.choice).toEqual({
      type: "object",
      properties: { read: { type: "string" }, write: { type: "string" } },
    });
    expect(schemas.either).toEqual({
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
    });
    expect(schemas.all).toEqual({
      type: "object",
      properties: { limit: { type: "integer" }, sort: { type: "string" } },
      required: ["limit", "sort"],
    });
  });

  test("keeps referenced and sibling parameters and required members", async () => {
    const [schema] = Object.values(await wiredSchemas([{
      name: "patched",
      description: "patched",
      parameters: {
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
      },
    } as OcxTool]));

    expect(Object.keys(schema!.properties as Record<string, unknown>).sort()).toEqual(["mode", "path"]);
    expect(schema!.required).toEqual(["path", "mode"]);
  });

  test("flattens composition inside a resolved $ref branch on the wire", async () => {
    const [schema] = Object.values(await wiredSchemas([{
      name: "nested_ref",
      description: "nested_ref",
      parameters: {
        $defs: {
          Args: {
            allOf: [{
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            }],
          },
        },
        allOf: [{ $ref: "#/$defs/Args" }],
      },
    } as OcxTool]));

    expect(schema!.properties).toEqual({ path: { type: "string" } });
    expect(schema!.required).toEqual(["path"]);
    expect(schema!.allOf).toBeUndefined();
  });

  test("preserves nested composition inside an outbound property", async () => {
    const nested = { anyOf: [{ type: "string" }, { type: "number" }] };
    const [schema] = Object.values(await wiredSchemas([{
      name: "nested",
      description: "nested",
      parameters: {
        oneOf: [{ type: "object", properties: { value: nested } }],
      },
    } as OcxTool]));

    expect((schema!.properties as Record<string, unknown>).value).toEqual(nested);
  });

  test("does not mutate the caller's tool schema", async () => {
    const parameters = {
      oneOf: [
        { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        { type: "object", properties: { mode: { type: "string" } } },
      ],
    };
    const before = structuredClone(parameters);

    await wiredSchemas([{ name: "sample", description: "sample", parameters } as OcxTool]);

    expect(parameters).toEqual(before);
    expect((parameters as Record<string, unknown>).type).toBeUndefined();
  });
});

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

  test("flattens composition inside a resolved $ref definition", () => {
    const normalized = normalizeAnthropicInputSchema({
      $defs: {
        Args: {
          allOf: [{
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          }],
        },
      },
      allOf: [{ $ref: "#/$defs/Args" }],
    });
    expect(normalized.allOf).toBeUndefined();
    expect(Object.keys(normalized.properties as Record<string, unknown>)).toEqual(["path"]);
    expect(normalized.required).toEqual(["path"]);
  });

  test("stops at a recursive local $ref chain without losing sibling branches", () => {
    const normalized = normalizeAnthropicInputSchema({
      $defs: {
        A: {
          allOf: [
            { $ref: "#/$defs/A" },
            { type: "object", properties: { leaf: { type: "string" } }, required: ["leaf"] },
          ],
        },
      },
      allOf: [{ $ref: "#/$defs/A" }],
    });
    expect(Object.keys(normalized.properties as Record<string, unknown>)).toEqual(["leaf"]);
    expect(normalized.required).toEqual(["leaf"]);
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

