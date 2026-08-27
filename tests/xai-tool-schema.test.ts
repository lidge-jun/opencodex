import { describe, expect, test } from "bun:test";
import {
  createOpenAIChatAdapter as createOpenAIChatAdapterProduction,
} from "../src/adapters/openai-chat";
import type {
  OcxParsedRequest,
  OcxTool,
} from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createOpenAIChatAdapter = (
  ...args: Parameters<typeof createOpenAIChatAdapterProduction>
) =>
  withTestTranslatorBudget(
    createOpenAIChatAdapterProduction(...args),
  );

function parsedRequest(
  tool: OcxTool,
): OcxParsedRequest {
  return {
    modelId: "grok-4.6",
    context: {
      messages: [
        {
          role: "user",
          content: "run the command",
          timestamp: 0,
        },
      ],
      tools: [tool],
    },
    stream: true,
    options: {},
  };
}

function xaiAdapter() {
  return createOpenAIChatAdapter({
    adapter: "openai-chat",
    baseUrl: "https://cli-chat-proxy.grok.com/v1",
    apiKey: "k",
  });
}

describe("xAI Grok CLI tool schema normalization", () => {
  test("keeps Claude Code tools with a root $schema", async () => {
    const tool: OcxTool = {
      name: "Bash",
      description: "Execute a shell command",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          command: {
            type: "string",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    };

    const request = await xaiAdapter().buildRequest(
      parsedRequest(tool),
    );

    const body = JSON.parse(request.body) as {
      tools?: Array<{
        type: string;
        function: {
          name: string;
          parameters: Record<string, unknown>;
        };
      }>;
    };

    expect(body.tools).toHaveLength(1);
    expect(body.tools?.[0]?.function.name).toBe("Bash");
    expect(body.tools?.[0]?.function.parameters).toEqual({
      type: "object",
      properties: {
        command: {
          type: "string",
        },
      },
      required: ["command"],
      additionalProperties: false,
    });
    expect(
      body.tools?.[0]?.function.parameters,
    ).not.toHaveProperty("$schema");
  });

  test("does not reintroduce $schema when flattening a root union", async () => {
    const tool: OcxTool = {
      name: "Bash",
      description: "Execute a shell command",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        oneOf: [
          {
            type: "object",
            properties: {
              command: {
                type: "string",
              },
            },
            required: ["command"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              command: {
                type: "string",
                minLength: 1,
              },
            },
            required: ["command"],
            additionalProperties: false,
          },
        ],
      },
    };

    const request = await xaiAdapter().buildRequest(
      parsedRequest(tool),
    );

    const body = JSON.parse(request.body) as {
      tools?: Array<{
        function: {
          parameters: Record<string, unknown>;
        };
      }>;
    };

    expect(body.tools).toHaveLength(1);
    expect(body.tools?.[0]?.function.parameters).toEqual({
    type: "object",
    properties: {
        command: {
        // The branches overlap, so `oneOf` exclusivity is load-bearing and is kept verbatim on
        // the property. Only the ROOT union is what this destination rejects.
        oneOf: [
            { type: "string" },
            { type: "string", minLength: 1 },
        ],
        },
    },
    required: ["command"],
    additionalProperties: false,
    });
  });

  test("hoists branch properties past a root additionalProperties:false, and keeps the restriction", async () => {
    // A root `additionalProperties: false` cannot see into `oneOf` branches, so the source schema
    // below forbids the very `mode` its branches require: verified with ajv, it validates NOTHING
    // — not `{}`, not `{mode:"view"}`. Flattening hoists `mode` beside the restriction, which is a
    // widening in the strict reading but only from the empty set, and the emitted schema still
    // carries `additionalProperties: false`, so `{other: 1}` and `{mode: "other"}` stay refused.
    // Same call as the duplicate-branch case: an unsatisfiable schema is a source bug no author
    // intends, and omitting the tool serves nobody.
    const request = await xaiAdapter().buildRequest(parsedRequest({
      name: "Bash",
      description: "Execute a shell command",
      parameters: {
        additionalProperties: false,
        oneOf: [
          { properties: { mode: { const: "view" } }, required: ["mode"] },
          { properties: { mode: { const: "edit" } }, required: ["mode"] },
        ],
      },
    }));
    const body = JSON.parse(request.body) as {
      tools?: Array<{ function: { parameters: Record<string, unknown> } }>;
    };

    expect(body.tools?.[0]?.function.parameters).toEqual({
      type: "object",
      properties: { mode: { anyOf: [{ const: "view" }, { const: "edit" }] } },
      required: ["mode"],
      additionalProperties: false,
    });
  });

  test("a satisfiable additionalProperties:false union keeps its exact accepted set", async () => {
    // The distinguishing case: `mode` is declared on the ROOT too, so the restriction never
    // forbade it and the source schema really does accept `view`/`edit`. Verified with ajv, the
    // original and the emitted schema accept exactly the same instances. Refusing every
    // composition that carries an explicit `additionalProperties` would drop this one for nothing.
    const request = await xaiAdapter().buildRequest(parsedRequest({
      name: "Bash",
      description: "Execute a shell command",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { mode: { type: "string" } },
        required: ["mode"],
        oneOf: [
          { properties: { mode: { const: "view" } } },
          { properties: { mode: { const: "edit" } } },
        ],
      },
    }));
    const body = JSON.parse(request.body) as {
      tools?: Array<{ function: { parameters: Record<string, unknown> } }>;
    };

    expect(body.tools?.[0]?.function.parameters).toEqual({
      type: "object",
      properties: {
        mode: {
          oneOf: [
            { allOf: [{ type: "string" }, { const: "view" }] },
            { allOf: [{ type: "string" }, { const: "edit" }] },
          ],
        },
      },
      required: ["mode"],
      additionalProperties: false,
    });
  });

  test("keeps an overlapping root oneOf exclusive instead of widening it to anyOf", async () => {
    // A root `oneOf` rejects an instance matching several branches. Flattening the differing
    // property to `anyOf` would accept `{ mode: "view" }`, which matches BOTH branches here and
    // the original therefore rejects.
    const request = await xaiAdapter().buildRequest(parsedRequest({
      name: "Bash",
      description: "Execute a shell command",
      parameters: {
        oneOf: [
          { type: "object", properties: { mode: { type: "string" } }, required: ["mode"] },
          { type: "object", properties: { mode: { const: "view" } }, required: ["mode"] },
        ],
      },
    }));
    const body = JSON.parse(request.body) as {
      tools?: Array<{ function: { parameters: Record<string, unknown> } }>;
    };

    expect(body.tools?.[0]?.function.parameters).toEqual({
      type: "object",
      properties: { mode: { oneOf: [{ type: "string" }, { const: "view" }] } },
      required: ["mode"],
    });
  });

  test("promotes an optional discriminator into required when flattening a root oneOf", async () => {
    // `mode` absent matches both branches, so the root `oneOf` rejects `{}`. A per-property union
    // alone would accept it; requiring the discriminator restores the original's accepted set.
    const request = await xaiAdapter().buildRequest(parsedRequest({
      name: "Bash",
      description: "Execute a shell command",
      parameters: {
        type: "object",
        oneOf: [
          { properties: { mode: { const: "view" } } },
          { properties: { mode: { const: "edit" } } },
        ],
      },
    }));
    const body = JSON.parse(request.body) as {
      tools?: Array<{ function: { parameters: Record<string, unknown> } }>;
    };

    expect(body.tools?.[0]?.function.parameters).toEqual({
      type: "object",
      properties: { mode: { anyOf: [{ const: "view" }, { const: "edit" }] } },
      required: ["mode"],
    });
  });

  test("collapses a root oneOf whose branches are identical", async () => {
    // Duplicated branches always match together, so the union strictly accepts nothing. No author
    // means that and no root object schema can express it, so the duplicates collapse and the tool
    // stays usable rather than vanishing over a source-schema bug.
    const request = await xaiAdapter().buildRequest(parsedRequest({
      name: "Bash",
      description: "Execute a shell command",
      parameters: {
        oneOf: [
          { type: "object", properties: { mode: { const: "view" } }, required: ["mode"] },
          { type: "object", properties: { mode: { const: "view" } }, required: ["mode"] },
        ],
      },
    }));
    const body = JSON.parse(request.body) as {
      tools?: Array<{ function: { parameters: Record<string, unknown> } }>;
    };

    expect(body.tools?.[0]?.function.parameters).toEqual({
      type: "object",
      properties: { mode: { const: "view" } },
      required: ["mode"],
    });
  });

  test("omits a oneOf nested inside another union rather than guessing its meaning", async () => {
    // `anyOf: [oneOf[V1, V2], V3]` accepts `{}` — it fails the inner `oneOf` but matches V3. A flat
    // variant list cannot say that, and promoting the discriminator into `required` would NARROW
    // the schema by rejecting it. Neither direction is faithful, so the tool is omitted.
    const request = await xaiAdapter().buildRequest(parsedRequest({
      name: "Bash",
      description: "Execute a shell command",
      parameters: {
        type: "object",
        anyOf: [
          {
            oneOf: [
              { properties: { mode: { const: "view" } } },
              { properties: { mode: { const: "edit" } } },
            ],
          },
          { properties: { mode: { const: "list" } } },
        ],
      },
    }));
    const body = JSON.parse(request.body) as { tools?: unknown[] };

    expect(body.tools).toBeUndefined();
  });

  test("bounds a nested root union instead of expanding 2^n variants", async () => {
    // 30 nested binary unions, every branch distinct, is 2^30 variants. Reaching the assertion at
    // all is the point: an unbounded walk never returns from this.
    let parameters: Record<string, unknown> = {
      type: "object",
      properties: { leaf: { type: "string" } },
      required: ["leaf"],
    };
    for (let depth = 0; depth < 30; depth += 1) {
      parameters = {
        oneOf: [
          { ...parameters, properties: { [`k${depth}`]: { const: `a${depth}` } } },
          { ...parameters, properties: { [`k${depth}`]: { const: `b${depth}` } } },
        ],
      };
    }

    const request = await xaiAdapter().buildRequest(parsedRequest({
      name: "Bash",
      description: "Execute a shell command",
      parameters,
    }));
    const body = JSON.parse(request.body) as { tools?: unknown[] };

    expect(body.tools).toBeUndefined();
  });

  test("omits a root union wider than the variant budget but keeps one within it", async () => {
    const flatUnion = (branches: number) => ({
      oneOf: Array.from({ length: branches }, (_, index) => ({
        type: "object",
        properties: { mode: { const: `m${index}` } },
        required: ["mode"],
      })),
    });
    const toolsFor = async (branches: number) => {
      const request = await xaiAdapter().buildRequest(parsedRequest({
        name: "Bash",
        description: "Execute a shell command",
        parameters: flatUnion(branches),
      }));
      return (JSON.parse(request.body) as { tools?: unknown[] }).tools;
    };

    expect(await toolsFor(200)).toHaveLength(1);
    expect(await toolsFor(300)).toBeUndefined();
  });

  test("omits a tool whose $ref graph fans out past the node budget", async () => {
    // Each level references the one below it twice. No cycle is ever formed, so the ref stack
    // alone does not stop it; only the node budget does.
    const defs: Record<string, unknown> = { level0: { type: "string" } };
    for (let level = 1; level <= 32; level += 1) {
      defs[`level${level}`] = {
        type: "object",
        properties: {
          left: { $ref: `#/$defs/level${level - 1}` },
          right: { $ref: `#/$defs/level${level - 1}` },
        },
      };
    }

    const request = await xaiAdapter().buildRequest(parsedRequest({
      name: "Bash",
      description: "Execute a shell command",
      parameters: {
        type: "object",
        $defs: defs,
        properties: { root: { $ref: "#/$defs/level32" } },
        required: ["root"],
      },
    }));
    const body = JSON.parse(request.body) as { tools?: unknown[] };

    expect(body.tools).toBeUndefined();
  });
});
