import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { applyProviderConfigHints, normalizeRoutedCatalogEntry } from "../src/codex/catalog";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxParsedRequest, OcxTool } from "../src/types";

const tools: OcxTool[] = [{ name: "shell", description: "run", parameters: { type: "object" } }];

function parsedRequest(overrides: Partial<OcxParsedRequest["options"]> = {}): Parameters<ReturnType<typeof createOpenAIChatAdapter>["buildRequest"]>[0] {
  return {
    modelId: "grok-4.5",
    context: {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
      tools,
    },
    stream: true,
    options: { ...overrides },
  } as never;
}

describe("parallel tool calls provider opt-in (request body)", () => {
  test("opted-in provider sends parallel_tool_calls:true by default", () => {
    const adapter = createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "k", parallelToolCalls: true });
    const body = JSON.parse(adapter.buildRequest(parsedRequest()).body) as Record<string, unknown>;
    expect(body.parallel_tool_calls).toBe(true);
  });

  test("opted-in provider honors an explicit request-level parallel_tool_calls:false (parser bit)", () => {
    const adapter = createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "k", parallelToolCalls: true });
    const body = JSON.parse(adapter.buildRequest(parsedRequest({ parallelToolCalls: false })).body) as Record<string, unknown>;
    expect(body.parallel_tool_calls).toBe(false);
  });

  test("default chat provider without explicit opt-in omits parallel_tool_calls", () => {
    const adapter = createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://api.z.ai/api/coding/paas/v4", apiKey: "k" });
    const body = JSON.parse(adapter.buildRequest(parsedRequest()).body) as Record<string, unknown>;
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });

  test("explicit provider false overrides even a permissive request bit by omitting parallel_tool_calls", () => {
    const adapter = createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "k", parallelToolCalls: false });
    const body = JSON.parse(adapter.buildRequest(parsedRequest({ parallelToolCalls: true })).body) as Record<string, unknown>;
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });

  test("pinParallelToolCallsFalse pins the wire bit for an opted-out non-NVIDIA provider", () => {
    const adapter = createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://llm.example.internal/v1", apiKey: "k", parallelToolCalls: false, pinParallelToolCallsFalse: true });
    const body = JSON.parse(adapter.buildRequest(parsedRequest()).body) as Record<string, unknown>;
    expect(body.parallel_tool_calls).toBe(false);
  });

  test("pinParallelToolCallsFalse keeps sending false even under a permissive request bit", () => {
    const adapter = createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://llm.example.internal/v1", apiKey: "k", parallelToolCalls: false, pinParallelToolCallsFalse: true });
    const body = JSON.parse(adapter.buildRequest(parsedRequest({ parallelToolCalls: true })).body) as Record<string, unknown>;
    expect(body.parallel_tool_calls).toBe(false);
  });

  test("pinParallelToolCallsFalse has no effect without parallelToolCalls:false", () => {
    const adapter = createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://llm.example.internal/v1", apiKey: "k", pinParallelToolCallsFalse: true });
    const body = JSON.parse(adapter.buildRequest(parsedRequest()).body) as Record<string, unknown>;
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });
});

describe("stale persisted config backfill (router)", () => {
  test("persisted xai config without the flag inherits registry parallelToolCalls:true", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "xai",
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          apiKey: "k",
          defaultModel: "grok-4.5",
          models: ["grok-4.5"],
        },
      },
    };
    const route = routeModel(config, "xai/grok-4.5");
    expect(route.provider.parallelToolCalls).toBe(true);
  });

  test("user-persisted explicit false overrides the registry opt-in", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "xai",
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          apiKey: "k",
          parallelToolCalls: false,
          defaultModel: "grok-4.5",
          models: ["grok-4.5"],
        },
      },
    };
    const route = routeModel(config, "xai/grok-4.5");
    expect(route.provider.parallelToolCalls).toBe(false);
  });
});

describe("catalog capability bit", () => {
  test("opted-in routed entry advertises supports_parallel_tool_calls", () => {
    const entry = normalizeRoutedCatalogEntry({ slug: "xai/grok-4.5" }, true);
    expect(entry.supports_parallel_tool_calls).toBe(true);
  });

  test("default routed entry does not advertise parallel support", () => {
    const entry = normalizeRoutedCatalogEntry({ slug: "opencode-go/glm-5.2" });
    expect(entry.supports_parallel_tool_calls).toBe(false);
  });

  test("cursor entries keep advertising parallel support unchanged", () => {
    const entry = normalizeRoutedCatalogEntry({ slug: "cursor/gpt-5.5" });
    expect(entry.supports_parallel_tool_calls).toBe(true);
  });

  test("applyProviderConfigHints propagates default-on for chat providers and explicit false opts out", () => {
    const hinted = applyProviderConfigHints(
      "xai",
      { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", parallelToolCalls: true },
      { id: "grok-4.5", provider: "xai" },
    );
    expect(hinted.parallelToolCalls).toBe(true);
    const defaultOn = applyProviderConfigHints(
      "zai",
      { adapter: "openai-chat", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
      { id: "glm-5.2", provider: "zai" },
    );
    expect(defaultOn.parallelToolCalls).toBe(true);
    const optedOut = applyProviderConfigHints(
      "zai",
      { adapter: "openai-chat", baseUrl: "https://api.z.ai/api/coding/paas/v4", parallelToolCalls: false },
      { id: "glm-5.2", provider: "zai" },
    );
    expect(optedOut.parallelToolCalls).toBeUndefined();
    const nonChat = applyProviderConfigHints(
      "xiaomi",
      { adapter: "anthropic", baseUrl: "https://api.xiaomimimo.com/anthropic" },
      { id: "mimo-v2.5-pro", provider: "xiaomi" },
    );
    expect(nonChat.parallelToolCalls).toBeUndefined();
  });
});

describe("assistant tool_calls history content hardening", () => {
  test("assistant message with tool_calls serializes content as empty string, never null", () => {
    const adapter = createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "k", parallelToolCalls: true });
    const request = adapter.buildRequest({
      modelId: "grok-4.5",
      context: {
        messages: [
          { role: "user", content: "run it", timestamp: 0 },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_1", name: "shell", arguments: { cmd: "ls" } }],
            timestamp: 0,
          },
          { role: "toolResult", toolCallId: "call_1", toolName: "shell", content: "ok", timestamp: 0 },
        ],
        tools,
      },
      stream: true,
      options: {},
    } as never);
    const body = JSON.parse(request.body) as { messages: Record<string, unknown>[] };
    const assistant = body.messages.find(m => m.role === "assistant" && m.tool_calls);
    expect(assistant?.content).toBe("");
    expect(assistant?.content).not.toBeNull();
  });

  test("orphan tool result synthesizes an assistant stub with empty-string content", () => {
    const adapter = createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "k" });
    const request = adapter.buildRequest({
      modelId: "grok-4.5",
      context: {
        messages: [
          { role: "user", content: "run it", timestamp: 0 },
          { role: "toolResult", toolCallId: "call_orphan", toolName: "shell", content: "ok", timestamp: 0 },
        ],
        tools,
      },
      stream: true,
      options: {},
    } as never);
    const body = JSON.parse(request.body) as { messages: Record<string, unknown>[] };
    const synthetic = body.messages.find(m => m.role === "assistant" && m.tool_calls);
    expect(synthetic?.content).toBe("");
  });
});
