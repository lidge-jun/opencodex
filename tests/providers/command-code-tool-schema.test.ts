import { describe, expect, spyOn, test } from "bun:test";
import { createCommandCodeAdapter } from "../../src/adapters/command-code";
import { normalizeAnthropicInputSchema } from "../../src/adapters/anthropic-input-schema";
import * as inputSchemas from "../../src/adapters/anthropic-input-schema";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig, OcxTool } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

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

describe("Command Code wireTools input_schema", () => {
  test("normalizes each visible tool once when preparing the wire and recovery views", async () => {
    const normalize = spyOn(inputSchemas, "normalizeAnthropicInputSchema");
    try {
      const parameters = { type: "object", properties: { path: { type: "string" } } };
      const schemas = await wiredSchemas([
        { name: "read", description: "Read", parameters },
        { name: "write", description: "Write", parameters },
      ]);
      expect(Object.keys(schemas)).toEqual(["read", "write"]);
      expect(normalize).toHaveBeenCalledTimes(2);
    } finally {
      normalize.mockRestore();
    }
  });

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

  test("keeps composition from both sides of a $ref with composing siblings", async () => {
    // JSON Schema conjoins a $ref with its siblings, so a sibling allOf adds to the referenced
    // definition's allOf instead of replacing it. Both-sided alternatives keep every branch's
    // properties and, like any root alternative, promote no required member.
    const schemas = await wiredSchemas([
      {
        name: "both_all",
        description: "both_all",
        parameters: {
          $defs: {
            A: { allOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }] },
          },
          allOf: [{
            $ref: "#/$defs/A",
            allOf: [{ type: "object", properties: { b: { type: "number" } }, required: ["b"] }],
          }],
        },
      },
      {
        name: "both_one",
        description: "both_one",
        parameters: {
          $defs: {
            A: {
              oneOf: [
                { type: "object", properties: { a1: { type: "string" } }, required: ["a1"] },
                { type: "object", properties: { a2: { type: "string" } }, required: ["a2"] },
              ],
            },
          },
          allOf: [{
            $ref: "#/$defs/A",
            oneOf: [
              { type: "object", properties: { b1: { type: "string" } }, required: ["b1"] },
              { type: "object", properties: { b2: { type: "string" } }, required: ["b2"] },
            ],
          }],
        },
      },
    ] as OcxTool[]);

    expect(schemas.both_all!.properties).toEqual({ a: { type: "string" }, b: { type: "number" } });
    expect([...(schemas.both_all!.required as string[])].sort()).toEqual(["a", "b"]);
    expect(Object.keys(schemas.both_one!.properties as object).sort()).toEqual(["a1", "a2", "b1", "b2"]);
    expect(schemas.both_one!.required).toBeUndefined();
    for (const schema of Object.values(schemas)) {
      expect(schema.allOf).toBeUndefined();
      expect(schema.oneOf).toBeUndefined();
    }
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

  test("rejects a shared $ref graph past the expansion limit instead of sending a partial schema", async () => {
    await expect(wiredSchemas([{
      name: "deep",
      description: "deep",
      parameters: sharedRefGraph(30),
    } as OcxTool])).rejects.toThrow(
      "tool input schema reference expansion exceeded the supported limit",
    );
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

  test("resolves a bounded shared $ref graph without losing its property", () => {
    const normalized = normalizeAnthropicInputSchema(sharedRefGraph(10));
    expect(normalized.properties).toEqual({ p: { type: "string" } });
    expect(normalized.required).toEqual(["p"]);
  });

  test("fails explicitly when a shared $ref graph exceeds the expansion limit", () => {
    expect(() => normalizeAnthropicInputSchema(sharedRefGraph(30))).toThrow(
      "tool input schema reference expansion exceeded the supported limit",
    );
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

describe("normalizeAnthropicInputSchema review follow-ups (#8873)", () => {
  const ARGS = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };

  test("percent-decodes a pointer fragment before splitting it (RFC 6901 section 6)", () => {
    const normalized = normalizeAnthropicInputSchema({
      $defs: { "My Args": ARGS },
      allOf: [{ $ref: "#/$defs/My%20Args" }],
    });
    expect(normalized.properties).toEqual({ path: { type: "string" } });
    expect(normalized.required).toEqual(["path"]);
  });

  test("a malformed percent escape stays an unresolved reference instead of throwing", () => {
    const normalized = normalizeAnthropicInputSchema({
      $defs: { Args: ARGS },
      allOf: [{ $ref: "#/$defs/%E0%A4%A" }],
    });
    expect(normalized.properties).toEqual({});
    expect(normalized.required).toBeUndefined();
  });

  test("numeric pointer tokens select array elements such as a composition branch", () => {
    const normalized = normalizeAnthropicInputSchema({
      $defs: { Wrapper: { allOf: [ARGS] } },
      allOf: [{ $ref: "#/$defs/Wrapper/allOf/0" }],
    });
    expect(normalized.properties).toEqual({ path: { type: "string" } });
    expect(normalized.required).toEqual(["path"]);
    // A token that is not a canonical index does not select an element.
    expect(normalizeAnthropicInputSchema({
      $defs: { Wrapper: { allOf: [ARGS] } },
      allOf: [{ $ref: "#/$defs/Wrapper/allOf/00" }],
    }).properties).toEqual({});
  });

  test("a direct $ref alias chain is bounded by the expansion limit", () => {
    const aliasChain = (length: number): Record<string, unknown> => {
      const defs: Record<string, unknown> = { A0: ARGS };
      for (let index = 1; index < length; index += 1) defs[`A${index}`] = { $ref: `#/$defs/A${index - 1}` };
      return { $defs: defs, allOf: [{ $ref: `#/$defs/A${length - 1}` }] };
    };
    expect(normalizeAnthropicInputSchema(aliasChain(40)).properties).toEqual({ path: { type: "string" } });
    expect(() => normalizeAnthropicInputSchema(aliasChain(10_000)))
      .toThrow("tool input schema reference expansion exceeded the supported limit");
  });

  test("conjoins same-name properties met on allOf paths instead of letting the later one win", () => {
    const normalized = normalizeAnthropicInputSchema({
      $defs: { Base: { allOf: [{ properties: { path: { type: "string", minLength: 1 } } }] } },
      properties: { mode: { type: "string" } },
      allOf: [
        { $ref: "#/$defs/Base", properties: { path: { maxLength: 10 } } },
        { properties: { mode: { enum: ["fast", "slow"] } } },
      ],
    });
    const properties = JSON.parse(JSON.stringify(normalized.properties)) as Record<string, unknown>;
    expect(properties.path).toEqual({ allOf: [{ maxLength: 10 }, { type: "string", minLength: 1 }] });
    expect(properties.mode).toEqual({ allOf: [{ type: "string" }, { enum: ["fast", "slow"] }] });
  });

  test("repeated allOf collisions extend one flat allOf list instead of nesting", () => {
    const normalized = normalizeAnthropicInputSchema({
      $defs: { Base: { allOf: [{ properties: { path: { pattern: "^src/" } } }] } },
      properties: { path: { type: "string" } },
      allOf: [
        { properties: { path: { minLength: 1 } } },
        { $ref: "#/$defs/Base", properties: { path: { maxLength: 10 } } },
        { properties: { path: { not: { const: "src/x" } } } },
      ],
    });
    const path = JSON.parse(JSON.stringify((normalized.properties as Record<string, unknown>).path));
    expect(path).toEqual({
      allOf: [
        { type: "string" },
        { minLength: 1 },
        { maxLength: 10 },
        { pattern: "^src/" },
        { not: { const: "src/x" } },
      ],
    });
  });

  test("a caller's own allOf property schema is kept as one member, not spliced", () => {
    const own = { allOf: [{ type: "string" }, { minLength: 1 }] };
    const normalized = normalizeAnthropicInputSchema({
      properties: { path: own },
      allOf: [{ properties: { path: { maxLength: 10 } } }],
    });
    expect(JSON.parse(JSON.stringify((normalized.properties as Record<string, unknown>).path)))
      .toEqual({ allOf: [own, { maxLength: 10 }] });
  });
});

describe("Command Code text-call recovery uses the wire schema (#8873)", () => {
  /** One MiMo text call through buildRequest, fetchResponse and parseStream. */
  async function recover(tool: OcxTool, parameters: Record<string, string>): Promise<{ calls: Array<{ name: string; args: string }>; text: string }> {
    const markup = `<tool_call>\n<function=${tool.name}>\n${Object.entries(parameters)
      .map(([key, value]) => `<parameter=${key}>\n${value}\n</parameter>\n`).join("")}</function>\n</tool_call>`;
    const events = [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", text: markup },
      { type: "text-end", id: "t" },
      { type: "finish", rawFinishReason: "stop" },
    ];
    const adapter = createCommandCodeAdapter({
      ...provider,
      fetch: (async () => new Response(events.map(event => JSON.stringify(event)).join("\n"))) as typeof fetch,
    } as OcxProviderConfig);
    const request = await adapter.buildRequest({ ...parsedRequest([tool]), modelId: "xiaomi/mimo-v2.6-flash" });
    const out: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(await adapter.fetchResponse!(request), createTestTranslatorBudget())) out.push(event);
    const calls: Array<{ name: string; args: string }> = [];
    let text = "";
    for (const event of out) {
      if (event.type === "tool_call_start") calls.push({ name: event.name, args: "" });
      if (event.type === "tool_call_delta") calls[calls.length - 1]!.args += event.arguments;
      if (event.type === "text_delta") text += event.text;
    }
    return { calls, text };
  }

  test("restores a MiMo text call for a root-composed tool", async () => {
    const tool = {
      name: "read_args",
      description: "Read a file",
      parameters: { allOf: [{ type: "object", properties: { path: { type: "string" } }, required: ["path"] }] },
    } as OcxTool;
    const { calls, text } = await recover(tool, { path: "src/a.ts" });
    expect(text).toBe("");
    expect(calls.map(call => call.name)).toEqual(["read_args"]);
    expect(JSON.parse(calls[0]!.args)).toEqual({ path: "src/a.ts" });
  });

  test("also validates against the declared schema, so a lossy wire flattening cannot admit a call", async () => {
    // The wire schema flattens the root anyOf away; the declared schema still requires
    // command or script, so a call carrying only cwd stays text instead of becoming a tool call.
    const tool = {
      name: "run",
      description: "Run something",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, script: { type: "string" }, cwd: { type: "string" } },
        anyOf: [{ required: ["command"] }, { required: ["script"] }],
      },
    } as OcxTool;
    const rejected = await recover(tool, { cwd: "/tmp" });
    expect(rejected.calls).toEqual([]);
    expect(rejected.text).toContain("<function=run>");
    const accepted = await recover(tool, { command: "ls", cwd: "/tmp" });
    expect(accepted.calls.map(call => call.name)).toEqual(["run"]);
    expect(JSON.parse(accepted.calls[0]!.args)).toEqual({ command: "ls", cwd: "/tmp" });
  });

  test("a declared schema the restored-value validator cannot evaluate keeps the markup as text", async () => {
    const tool = {
      name: "read_ref",
      description: "Read a file",
      parameters: {
        $defs: { Args: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
        allOf: [{ $ref: "#/$defs/Args" }],
      },
    } as OcxTool;
    const { calls, text } = await recover(tool, { path: "src/a.ts" });
    expect(calls).toEqual([]);
    expect(text).toContain("<function=read_ref>");
  });
});
