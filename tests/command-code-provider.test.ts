import { describe, expect, test } from "bun:test";
import { createCommandCodeAdapter } from "../src/adapters/command-code";
import { parseCommandCodeCallback } from "../src/oauth/command-code";
import { OAUTH_PROVIDERS } from "../src/oauth";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const provider: OcxProviderConfig = {
  adapter: "command-code",
  baseUrl: "https://api.commandcode.ai",
  authMode: "oauth",
  apiKey: "secret-command-key",
  defaultMaxOutputTokens: 64_000,
};

function parsed(modelId = "kimi-k3"): OcxParsedRequest {
  return {
    modelId,
    stream: true,
    context: {
      systemPrompt: ["system"],
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools: [{ name: "lookup", description: "lookup", parameters: { type: "object" } }],
    },
    options: { reasoning: "high", maxOutputTokens: 100 },
  };
}

describe("Command Code provider", () => {
  test("registry and OAuth surfaces stay in parity", () => {
    const registry = PROVIDER_REGISTRY.find(row => row.id === "command-code");
    expect(registry).toMatchObject({
      adapter: "command-code",
      authKind: "oauth",
      defaultModel: "deepseek-v4-flash",
      models: ["deepseek-v4-flash", "kimi-k3", "glm-5.2"],
    });
    expect(OAUTH_PROVIDERS["command-code"]?.providerConfig).toMatchObject({
      adapter: "command-code",
      baseUrl: "https://api.commandcode.ai",
      authMode: "oauth",
    });
  });

  test("validates callback shape and state without exposing the key", () => {
    expect(parseCommandCodeCallback({ apiKey: "key", state: "state", userId: "u", userName: "name", keyName: "cli" }, "state")).toMatchObject({ userId: "u" });
    expect(() => parseCommandCodeCallback({ apiKey: "key", state: "wrong", userId: "u", userName: "name", keyName: "cli" }, "state")).toThrow("state mismatch");
  });

  test("builds the proprietary generate request with canonical model and bearer auth", () => {
    const request = createCommandCodeAdapter(provider).buildRequest(parsed());
    expect(request).not.toBeInstanceOf(Promise);
    const built = request as Exclude<typeof request, Promise<unknown>>;
    const body = JSON.parse(built.body);
    expect(built.url).toBe("https://api.commandcode.ai/alpha/generate");
    expect(built.headers.Authorization).toBe("Bearer secret-command-key");
    expect(body.params).toMatchObject({ model: "moonshotai/Kimi-K3", reasoning_effort: "high", max_tokens: 100, stream: true });
    expect(body.params.tools[0]).toMatchObject({ name: "lookup" });
    expect(built.body).not.toContain("secret-command-key");
  });

  test("parses NDJSON text, reasoning, tools, usage, and finish", async () => {
    const response = new Response([
      JSON.stringify({ type: "reasoning-delta", text: "think" }),
      JSON.stringify({ type: "text-delta", text: "hello" }),
      JSON.stringify({ type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: { q: "x" } }),
      JSON.stringify({ type: "finish", rawFinishReason: "tool_use", totalUsage: { inputTokens: 10, outputTokens: 4, inputTokenDetails: { cacheReadTokens: 8 } } }),
    ].join("\n"));
    const events = [];
    for await (const event of createCommandCodeAdapter(provider).parseStream(response, createTestTranslatorBudget())) events.push(event);
    expect(events).toEqual([
      { type: "thinking_delta", thinking: "think" },
      { type: "text_delta", text: "hello" },
      { type: "tool_call_start", id: "call_1", name: "lookup" },
      { type: "tool_call_delta", arguments: '{"q":"x"}' },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 8, cacheReadInputTokens: 8 }, stopReason: "tool_use" },
    ]);
  });
});
