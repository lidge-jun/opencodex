import { describe, expect, test } from "bun:test";
import { buildOpenAIChatPassthroughRequest, createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { applyProviderConfigHints, normalizeRoutedCatalogEntry } from "../../src/codex/catalog";
import { routeModel } from "../../src/router";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig, OcxTool } from "../../src/types";

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

/**
 * #5211 case 2. The provider knob has three states and the call site only branched on two, so
 * the default state — a provider that never configured it — dropped the caller's own explicit
 * `parallel_tool_calls: false` on the way to the wire while still answering normally. The
 * assertions read the request body because a successful tool call cannot tell the difference.
 */
describe("caller-specified parallel_tool_calls on a provider that expresses no preference", () => {
  const unsetProvider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://gateway.example.internal/v1", apiKey: "k" };

  test("an explicit request-level false reaches the outbound request", () => {
    const adapter = createOpenAIChatAdapter(unsetProvider);
    const body = JSON.parse(adapter.buildRequest(parsedRequest({ parallelToolCalls: false })).body) as Record<string, unknown>;
    expect(body.parallel_tool_calls).toBe(false);
  });

  test("an explicit request-level true still omits the knob strict hosts never had to accept", () => {
    const adapter = createOpenAIChatAdapter(unsetProvider);
    const body = JSON.parse(adapter.buildRequest(parsedRequest({ parallelToolCalls: true })).body) as Record<string, unknown>;
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });

  test("a request that says nothing leaves the key absent", () => {
    const adapter = createOpenAIChatAdapter(unsetProvider);
    const body = JSON.parse(adapter.buildRequest(parsedRequest()).body) as Record<string, unknown>;
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });

  test("a toolless request never grows the key", () => {
    const adapter = createOpenAIChatAdapter(unsetProvider);
    const toolless = { ...parsedRequest({ parallelToolCalls: false }), context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] } } as never;
    const body = JSON.parse(adapter.buildRequest(toolless).body) as Record<string, unknown>;
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });

  // The native Chat route never projects the body, so it read the same three provider states
  // from its own copy of the branch and lost the caller's false in exactly the same way.
  describe("native Chat passthrough", () => {
    function passthroughBody(provider: OcxProviderConfig, raw: Record<string, unknown>): Record<string, unknown> {
      const request = buildOpenAIChatPassthroughRequest(provider, {
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "shell", parameters: { type: "object" } } }],
        ...raw,
      }, "grok-4.5", false);
      return JSON.parse(request.body) as Record<string, unknown>;
    }

    test("an explicit request-level false reaches the outbound request", () => {
      expect(passthroughBody(unsetProvider, { parallel_tool_calls: false }).parallel_tool_calls).toBe(false);
    });

    test("an explicit true and an absent value both leave the key off", () => {
      expect(passthroughBody(unsetProvider, { parallel_tool_calls: true })).not.toHaveProperty("parallel_tool_calls");
      expect(passthroughBody(unsetProvider, {})).not.toHaveProperty("parallel_tool_calls");
    });

    test("the configured states keep their existing wire values", () => {
      const optedIn = { ...unsetProvider, parallelToolCalls: true };
      expect(passthroughBody(optedIn, {}).parallel_tool_calls).toBe(true);
      expect(passthroughBody(optedIn, { parallel_tool_calls: false }).parallel_tool_calls).toBe(false);
      const optedOut = { ...unsetProvider, parallelToolCalls: false };
      expect(passthroughBody(optedOut, { parallel_tool_calls: true })).not.toHaveProperty("parallel_tool_calls");
      expect(passthroughBody({ ...optedOut, pinParallelToolCallsFalse: true }, { parallel_tool_calls: true }).parallel_tool_calls)
        .toBe(false);
    });
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
