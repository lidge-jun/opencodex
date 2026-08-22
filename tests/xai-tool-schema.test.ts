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
        anyOf: [
            { type: "string" },
            { type: "string", minLength: 1 },
        ],
        },
    },
    required: ["command"],
    additionalProperties: false,
    });
  });
});