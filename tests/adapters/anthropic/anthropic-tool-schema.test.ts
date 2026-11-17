import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import type { OcxParsedRequest, OcxProviderConfig, OcxTool } from "../../../src/types";

const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-x", authMode: "apiKey" } as unknown as OcxProviderConfig;

async function toolsOf(tools: OcxTool[]): Promise<Array<{ name: string; input_schema: Record<string, unknown> }>> {
  const parsed: OcxParsedRequest = {
    modelId: "anthropic/claude-sonnet-4.5",
    stream: false,
    options: {},
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }], tools },
  };
  const { body } = await createAnthropicAdapter(provider).buildRequest(parsed);
  const parsedBody = JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as {
    tools: Array<{ name: string; input_schema: Record<string, unknown> }>;
  };
  return parsedBody.tools;
}

async function toolSchema(parameters: unknown): Promise<Record<string, unknown>> {
  const [tool] = await toolsOf([{ name: "sample_tool", description: "Sample", parameters } as OcxTool]);
  return tool.input_schema;
}

/** A diamond of local refs: each level references the previous definition twice. */
function sharedRefGraph(depth: number): Record<string, unknown> {
  const defs: Record<string, unknown> = {
    A0: { type: "object", properties: { p: { type: "string" } }, required: ["p"] },
  };
  for (let index = 1; index <= depth; index += 1) {
    defs[`A${index}`] = {
      allOf: [
        { $ref: `#/$defs/A${index - 1}` },
        { $ref: `#/$defs/A${index - 1}` },
      ],
    };
  }
  return { $defs: defs, allOf: [{ $ref: `#/$defs/A${depth}` }] };
}

describe("anthropic tool input_schema normalization", () => {
  test("parameterless and type-less tools become valid object schemas", async () => {
    expect(await toolSchema({})).toEqual({ type: "object", properties: {} });
    expect(await toolSchema({ properties: { query: { type: "string" } }, required: ["query"] })).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
  });

  test("an already-valid object schema passes through untouched", async () => {
    const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
    expect(await toolSchema({ ...schema })).toEqual(schema);
  });

  test("object schema with type but no properties gains an empty properties map", async () => {
    expect(await toolSchema({ type: "object" })).toEqual({ type: "object", properties: {} });
  });

  test("root oneOf and anyOf are flattened without promoting branch required fields", async () => {
    const anyOf = await toolSchema({
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

    expect(await toolSchema({
      oneOf: [
        { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      ],
    })).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
    });
  });

  test("root allOf merges required fields and preserves sibling schema metadata", async () => {
    expect(await toolSchema({
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

  test("nested composition under properties is preserved", async () => {
    expect(await toolSchema({
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

  test("resolves a local $ref allOf branch and keeps its required member", async () => {
    const schema = await toolSchema({
      $defs: {
        Args: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      allOf: [{ $ref: "#/$defs/Args" }],
    });
    expect(schema.properties).toEqual({ path: { type: "string" } });
    expect(schema.required).toEqual(["path"]);
  });

  test("flattens composition inside a resolved $ref definition", async () => {
    const schema = await toolSchema({
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
    expect(schema.properties).toEqual({ path: { type: "string" } });
    expect(schema.required).toEqual(["path"]);
  });

  test("fails explicitly when a shared $ref graph exceeds the expansion limit", async () => {
    await expect(toolSchema(sharedRefGraph(30))).rejects.toThrow(
      "tool input schema reference expansion exceeded the supported limit",
    );
  });

  test("merges $ref siblings conjunctively and unions required members", async () => {
    const schema = await toolSchema({
      $defs: {
        Base: {
          type: "object",
          properties: { path: { type: "string", minLength: 1 } },
          required: ["path"],
        },
      },
      allOf: [{
        $ref: "#/$defs/Base",
        properties: {
          path: { type: "string", maxLength: 64 },
          mode: { type: "string" },
        },
        required: ["mode"],
      }],
    });
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties).sort()).toEqual(["mode", "path"]);
    expect(properties.path).toEqual({
      allOf: [
        { type: "string", minLength: 1 },
        { type: "string", maxLength: 64 },
      ],
    });
    expect(schema.required).toEqual(["path", "mode"]);
  });

  test("keeps the documented last-branch-wins loss for root alternatives", async () => {
    const schema = await toolSchema({
      oneOf: [
        { type: "object", properties: { action: { enum: ["read"] } } },
        { type: "object", properties: { action: { enum: ["write"] } } },
      ],
    });
    expect((schema.properties as Record<string, unknown>).action).toEqual({ enum: ["write"] });
  });

  test("strips Codex's Responses-only encrypted marker from collaboration schemas", async () => {
    const inputSchema = await toolSchema({
      type: "object",
      properties: {
        message: { type: "string", encrypted: true },
      },
      required: ["message"],
    });

    expect(JSON.stringify(inputSchema)).not.toContain('"encrypted"');
    expect(inputSchema.properties).toEqual({ message: { type: "string" } });
    expect(inputSchema.required).toEqual(["message"]);
  });

  test("preserves a property literally named encrypted", async () => {
    expect((await toolSchema({
      type: "object",
      properties: { encrypted: { type: "boolean" } },
    })).properties).toEqual({ encrypted: { type: "boolean" } });
  });

  test("strips the marker under items, nested properties, and flattened root anyOf branches", async () => {
    const inputSchema = await toolSchema({
      type: "object",
      properties: {
        list: { type: "array", items: { type: "string", encrypted: true } },
        outer: {
          type: "object",
          properties: { nested: { type: "number", encrypted: true } },
        },
      },
      anyOf: [
        { type: "object", properties: { fromBranch: { type: "boolean", encrypted: true } } },
      ],
    });

    const properties = inputSchema.properties as Record<string, Record<string, unknown>>;
    expect((properties.list.items as Record<string, unknown>).encrypted).toBeUndefined();
    expect(((properties.outer.properties as Record<string, Record<string, unknown>>).nested).encrypted).toBeUndefined();
    expect(properties.fromBranch.encrypted).toBeUndefined();
  });

  test("preserves literal encrypted values, required names, and encrypted definition names", async () => {
    const inputSchema = await toolSchema({
      type: "object",
      default: { encrypted: true },
      required: ["encrypted"],
      $defs: { encrypted: { type: "string" } },
      properties: {
        constant: { const: { encrypted: true } },
        choices: { enum: [{ encrypted: true }] },
      },
    });

    expect(inputSchema.default).toEqual({ encrypted: true });
    expect(inputSchema.required).toEqual(["encrypted"]);
    expect(inputSchema.$defs).toEqual({ encrypted: { type: "string" } });
    expect(inputSchema.properties).toEqual({
      constant: { const: { encrypted: true } },
      choices: { enum: [{ encrypted: true }] },
    });
  });

  test("does not mutate the input schema", async () => {
    const schema = {
      type: "object",
      properties: { message: { type: "string", encrypted: true } },
    };
    const before = structuredClone(schema);

    await toolSchema(schema);

    expect(schema).toEqual(before);
  });
});
