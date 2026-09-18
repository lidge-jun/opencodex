import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { routeModel } from "../../src/router";
import type { OcxConfig } from "../../src/types";

function configFor(modelId: string): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": {
        adapter: "openai-chat",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "key",
        models: [modelId],
      },
    },
  };
}

function buildToolCallBody(modelId: string, reasoning: string): {
  reasoning_effort?: string;
  messages: Record<string, unknown>[];
} {
  const route = routeModel(configFor(modelId), `opencode-go/${modelId}`);
  const req = createOpenAIChatAdapter(route.provider).buildRequest({
    modelId: route.modelId,
    context: {
      messages: [
        { role: "user", content: "inspect the repo", timestamp: 0 },
        { role: "assistant", timestamp: 1, content: [
          { type: "thinking", thinking: "I need to inspect files before answering." },
          { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "README.md" } },
        ] },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read_file",
          content: "contents",
          isError: false,
          timestamp: 2,
        },
      ],
    },
    stream: true,
    options: { reasoning },
  });

  return JSON.parse(req.body as string) as {
    reasoning_effort?: string;
    messages: Record<string, unknown>[];
  };
}

describe("opencode-go DeepSeek V4 thinking mode", () => {
  test("normalizes Desktop-style root composition schemas for Console Go", () => {
    const route = routeModel(configFor("deepseek-v4.1-flash"), "opencode-go/deepseek-v4.1-flash");
    const req = createOpenAIChatAdapter(route.provider).buildRequest({
      modelId: route.modelId,
      context: {
        messages: [{ role: "user", content: "inspect the repo", timestamp: 0 }],
        tools: [{
          name: "automation_update",
          description: "Update an automation",
          parameters: {
            oneOf: [
              {
                type: "object",
                properties: { mode: { $ref: "#/$defs/mode" } },
                required: ["mode"],
              },
              {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
              },
            ],
            $defs: { mode: { type: "string", enum: ["create", "update"] } },
          },
        }],
      },
      stream: true,
      options: { reasoning: "high" },
    });

    const body = JSON.parse(req.body as string) as {
      tools: Array<{ function: { parameters: Record<string, unknown> } }>;
    };
    const parameters = body.tools[0].function.parameters;

    expect(parameters.type).toBe("object");
    expect(parameters.oneOf).toBeUndefined();
    expect(parameters.properties).toEqual({
      mode: { $ref: "#/$defs/mode" },
      id: { type: "string" },
    });
    expect(parameters.$defs).toEqual({
      mode: { type: "string", enum: ["create", "update"] },
    });
  });

  test.each(["deepseek-v4-flash", "deepseek-v4.1-flash"])(
    "%s replays tool-call reasoning and maps Codex efforts",
    modelId => {
      const xhighBody = buildToolCallBody(modelId, "xhigh");
      const mediumBody = buildToolCallBody(modelId, "medium");

      // #1057: `xhigh` is a vendor alias. Since the V4 Pro GA (DeepSeek-V4-Pro-0813)
      // it resolves to high on BOTH models (api-docs.deepseek.com/guides/thinking_mode,
      // verified 2026-08-13).
      expect(xhighBody.reasoning_effort).toBe("high");
      expect(mediumBody.reasoning_effort).toBe("high");
      expect(xhighBody.messages[1].reasoning_content).toBe("I need to inspect files before answering.");
      expect(xhighBody.messages[1]).toMatchObject({
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) },
        }],
      });
    },
  );

  test("non-listed opencode-go models do not replay reasoning_content", () => {
    const body = buildToolCallBody("minimax-m2.7", "medium");

    expect(body.messages[1].reasoning_content).toBeUndefined();
    expect(body.messages[1]).toHaveProperty("tool_calls");
  });
});

/*
 * Issues #1338 / #1415: the Zen Go upstream answers a `json_schema` response_format with
 * HTTP 400 "This response_format type is unavailable now" on its DeepSeek routes, which
 * kills every Codex auto-review turn there. The preset now carries that fact, so the
 * request is downgraded to `json_object` instead of the operator having to disable
 * structured output by hand.
 */
describe("opencode-go DeepSeek json_schema downgrade", () => {
  const buildWith = (modelId: string, extra: Record<string, unknown> = {}) => {
    const config = configFor(modelId);
    Object.assign(config.providers["opencode-go"], extra);
    const route = routeModel(config, `opencode-go/${modelId}`);
    const req = createOpenAIChatAdapter(route.provider).buildRequest({
      modelId: route.modelId,
      context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      options: { textFormat: { type: "json_schema", name: "review", schema: { type: "object" }, strict: true } },
      stream: false,
    });
    return {
      provider: route.provider,
      body: JSON.parse(req.body as string) as { response_format?: { type?: string } },
    };
  };

  test("the preset reaches the routed provider", () => {
    expect(buildWith("deepseek-v4-flash").provider.noJsonSchemaModels)
      .toEqual(["deepseek-v4.1-flash", "deepseek-v4-flash"]);
  });

  test("a listed DeepSeek route is downgraded to json_object", () => {
    expect(buildWith("deepseek-v4-flash").body.response_format).toEqual({ type: "json_object" });
    expect(buildWith("deepseek-v4.1-flash").body.response_format).toEqual({ type: "json_object" });
  });

  test("an unlisted sibling on the same gateway keeps its schema", () => {
    expect(buildWith("glm-5.3").body.response_format?.type).toBe("json_schema");
  });

  test("the operator kill switch still wins over the downgrade", () => {
    const { body } = buildWith("deepseek-v4-flash", { noStructuredOutputModels: ["deepseek-v4-flash"] });
    expect(body.response_format).toBeUndefined();
  });

  test("a json_object request is left alone on a listed route", () => {
    const config = configFor("deepseek-v4-flash");
    const route = routeModel(config, "opencode-go/deepseek-v4-flash");
    const req = createOpenAIChatAdapter(route.provider).buildRequest({
      modelId: route.modelId,
      context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      options: { textFormat: { type: "json_object" } },
      stream: false,
    });
    expect((JSON.parse(req.body as string) as { response_format?: unknown }).response_format)
      .toEqual({ type: "json_object" });
  });
});
