import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";

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
    const route = routeModel(configFor("deepseek-v4-pro"), "opencode-go/deepseek-v4-pro");
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

  test.each(["deepseek-v4-flash", "deepseek-v4-pro"])(
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
