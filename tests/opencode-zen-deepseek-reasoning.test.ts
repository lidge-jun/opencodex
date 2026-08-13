import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";

function configFor(modelId: string): OcxConfig {
  return {
    port: 10110,
    defaultProvider: "opencode-zen",
    providers: {
      "opencode-zen": {
        adapter: "openai-chat",
        baseUrl: "https://opencode.ai/zen/v1",
        apiKey: "key",
        models: [modelId],
      },
    },
  };
}

function buildToolCallBody(modelId: string, reasoning?: string): {
  reasoning_effort?: string;
  messages: Record<string, unknown>[];
} {
  const route = routeModel(configFor(modelId), `opencode-zen/${modelId}`);
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
    options: { reasoning: reasoning ?? "max" },
  });

  return JSON.parse(req.body as string) as {
    reasoning_effort?: string;
    messages: Record<string, unknown>[];
  };
}

describe("opencode-zen DeepSeek thinking mode", () => {
  test.each(["deepseek-v4-flash-free", "deepseek-v4-flash", "deepseek-v4-pro"])(
    "%s replays tool-call reasoning_content and maps Codex efforts (issue #950/#994)",
    modelId => {
      const body = buildToolCallBody(modelId, "xhigh");

      // V4 Pro GA (DeepSeek-V4-Pro-0813): xhigh resolves to high on both V4 models.
      const expectedEffort = "high";
      expect(body.reasoning_effort).toBe(expectedEffort);
      expect(body.messages[1].reasoning_content).toBe("I need to inspect files before answering.");
      expect(body.messages[1]).toMatchObject({
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

  test("non-DeepSeek opencode-zen models do not replay reasoning_content", () => {
    const body = buildToolCallBody("minimax-m2.7");

    expect(body.messages[1].reasoning_content).toBeUndefined();
    expect(body.messages[1]).toHaveProperty("tool_calls");
  });

  test.each(["deepseek-v4-flash-free", "deepseek-v4-flash", "deepseek-v4-pro"])(
    "%s is listed in opencode-zen noVisionModels for the vision sidecar",
    modelId => {
      const route = routeModel(configFor(modelId), `opencode-zen/${modelId}`);

      expect(route.provider.noVisionModels).toContain(modelId);
    },
  );

  test("Zen text-only free models (measured #1043) stay in noVisionModels", () => {
    const route = routeModel(configFor("big-pickle"), "opencode-zen/big-pickle");

    expect(route.provider.noVisionModels).toContain("big-pickle");
  });


  test("non-DeepSeek opencode-zen models stay out of noVisionModels", () => {
    const route = routeModel(configFor("minimax-m2.7"), "opencode-zen/minimax-m2.7");

    expect(route.provider.noVisionModels).not.toContain("minimax-m2.7");
  });
});
