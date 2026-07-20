import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    apiKey: "sk-test",
    authMode: "key",
    preserveReasoningContentModels: ["qwen3.8-max-preview"],
    thinkingBudgetModels: ["qwen3.8-max-preview"],
    ...overrides,
  };
}

function parsedWithThinkingHistory(): OcxParsedRequest {
  return {
    modelId: "qwen3.8-max-preview",
    context: {
      messages: [
        { role: "user", content: "fix the bug in auth.ts", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me analyze the auth flow step by step..." },
            { type: "text", text: "I found the issue. Let me read the file." },
            { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "auth.ts" } },
          ],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read_file",
          content: "export function login() { ... }",
          isError: false,
          timestamp: 3,
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "The token validation is missing expiry check..." },
            { type: "text", text: "I see the problem. Applying fix." },
            { type: "toolCall", id: "call_2", name: "apply_patch", arguments: { patch: "..." } },
          ],
          timestamp: 4,
        },
        {
          role: "toolResult",
          toolCallId: "call_2",
          toolName: "apply_patch",
          content: "patch applied",
          isError: false,
          timestamp: 5,
        },
        { role: "user", content: "now run the tests", timestamp: 6 },
      ],
    },
    stream: false,
    options: {},
  };
}

describe("Qwen 3.8 reasoning_content preservation", () => {
 test("replays reasoning_content for all prior assistant turns when model is in preserveReasoningContentModels", () => {
   const adapter = createOpenAIChatAdapter(provider());
    const result = adapter.buildRequest(parsedWithThinkingHistory());
    const body = JSON.parse(result.body as string) as Record<string, unknown>;
    const messages = body.messages as Record<string, unknown>[];

    // Find assistant messages
    const assistantMsgs = messages.filter(m => m.role === "assistant");
    expect(assistantMsgs.length).toBe(2);

    // Both should have reasoning_content
    expect(assistantMsgs[0].reasoning_content).toBe("Let me analyze the auth flow step by step...");
    expect(assistantMsgs[1].reasoning_content).toBe("The token validation is missing expiry check...");

    // reasoning_content should NOT be merged into content
    expect(assistantMsgs[0].content).not.toContain("Let me analyze");
    expect(assistantMsgs[1].content).not.toContain("The token validation");

    // tool_calls should still be present
    expect(assistantMsgs[0].tool_calls).toBeDefined();
    expect(assistantMsgs[1].tool_calls).toBeDefined();
  });

 test("does NOT replay reasoning_content for models outside preserveReasoningContentModels", () => {
   const adapter = createOpenAIChatAdapter(provider({
     preserveReasoningContentModels: ["some-other-model"],
   }));
    const result = adapter.buildRequest(parsedWithThinkingHistory());
    const body = JSON.parse(result.body as string) as Record<string, unknown>;
    const messages = body.messages as Record<string, unknown>[];

    const assistantMsgs = messages.filter(m => m.role === "assistant");
    expect(assistantMsgs.length).toBe(2);

    // Neither should have reasoning_content
    expect(assistantMsgs[0].reasoning_content).toBeUndefined();
    expect(assistantMsgs[1].reasoning_content).toBeUndefined();
  });

  test("registry includes qwen3.8-max-preview in alibaba-token-plan preserveReasoningContentModels", async () => {
    const { PROVIDER_REGISTRY } = await import("../src/providers/registry");
    const alibaba = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan");
    expect(alibaba).toBeDefined();
    expect(alibaba!.preserveReasoningContentModels).toContain("qwen3.8-max-preview");
  });
});
