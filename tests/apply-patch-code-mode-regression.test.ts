import { expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const provider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://api.x.ai/v1",
  apiKey: "test-key",
};

test("routed Code Mode does not forbid nested apply_patch when it is absent from the flat catalog", () => {
  const parsed: OcxParsedRequest = {
    modelId: "grok-4.6",
    context: {
      systemPrompt: ["Use apply_patch for local file edits."],
      messages: [{ role: "user", content: "Edit the requested file.", timestamp: 0 }],
      tools: [
        {
          name: "exec",
          description: "Run JavaScript. declare const tools: { apply_patch(input: string): Promise<unknown>; };",
          parameters: {},
        },
        { name: "wait", description: "Wait for an exec cell.", parameters: {} },
        { name: "request_user_input", description: "Ask the user a question.", parameters: {} },
      ],
    },
    stream: false,
    options: {},
  };

  const request = createOpenAIChatAdapter(provider).buildRequest(parsed);
  const body = JSON.parse(request.body) as {
    messages: Array<{ role: string; content: unknown }>;
    tools?: Array<{ function?: { name?: string; description?: string } }>;
  };

  const systemText = body.messages
    .filter(message => message.role === "system" && typeof message.content === "string")
    .map(message => message.content as string)
    .join("\n");
  const execTool = body.tools?.find(tool => tool.function?.name === "exec");

  // Reproduce the actual Code Mode shape: patching exists only as a nested exec helper,
  // not as a top-level wire tool. Before 0325a5a the injected nudge contradicted this
  // contract by explicitly forbidding apply_patch, which pushed routed models to Python/sed.
  expect(execTool?.function?.description).toContain("apply_patch");
  expect(body.tools?.some(tool => tool.function?.name === "apply_patch")).toBe(false);
  expect(systemText).toContain("Use apply_patch for local file edits.");
  expect(systemText).toContain("Valid tool names for this turn are exactly `exec`, `wait`, `request_user_input`");
  expect(systemText).toContain("Do not use neighboring-agent tool names");
  expect(systemText).not.toMatch(/Do not use neighboring-agent tool names[^.]*apply_patch/);
});
