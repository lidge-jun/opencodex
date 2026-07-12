import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { buildModelsRequest } from "../src/oauth";
import {
  resolveProviderTransport,
  deriveXaiConvId,
  XAI_CONV_ID_HEADER,
  XAI_GROK_CLI_BASE_URL,
  XAI_GROK_CLIENT_VERSION,
} from "../src/providers/xai-transport";
import { getProviderRegistryEntry } from "../src/providers/registry";
import type { OcxAssistantMessage, OcxParsedRequest, OcxProviderConfig } from "../src/types";

function provider(authMode: "oauth" | "key"): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://api.x.ai/v1",
    authMode,
    apiKey: authMode === "oauth" ? "oauth-token" : "xai-api-key",
    defaultModel: "grok-4.5",
  };
}

function parsed(): OcxParsedRequest {
  return {
    modelId: "grok-4.5",
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    stream: false,
    options: { reasoning: "low" },
  };
}

describe("xAI auth-mode transport selection", () => {
  test("OAuth selects the Grok CLI subscription transport and required headers", () => {
    const effective = resolveProviderTransport("xai", provider("oauth"));
    const request = createOpenAIChatAdapter(effective).buildRequest(parsed());

    expect(effective.baseUrl).toBe(XAI_GROK_CLI_BASE_URL);
    expect(request.url).toBe(`${XAI_GROK_CLI_BASE_URL}/chat/completions`);
    expect(request.headers).toMatchObject({
      Authorization: "Bearer oauth-token",
      "x-grok-client-identifier": "opencodex",
      "x-grok-client-version": XAI_GROK_CLIENT_VERSION,
      "x-xai-token-auth": "xai-grok-cli",
    });
  });

  test("OAuth model discovery uses the subscription transport", () => {
    const request = buildModelsRequest(provider("oauth"), "oauth-token", "xai");

    expect(request.url).toBe(`${XAI_GROK_CLI_BASE_URL}/models`);
    expect(request.headers).toMatchObject({
      Authorization: "Bearer oauth-token",
      "x-grok-client-identifier": "opencodex",
      "x-grok-client-version": XAI_GROK_CLIENT_VERSION,
      "x-xai-token-auth": "xai-grok-cli",
    });
  });

  test("API key keeps the xAI API transport without subscription headers", () => {
    const configured = provider("key");
    const effective = resolveProviderTransport("xai", configured);
    const request = createOpenAIChatAdapter(effective).buildRequest(parsed());
    const modelsRequest = buildModelsRequest(configured, "xai-api-key", "xai");

    expect(effective).toBe(configured);
    expect(request.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(modelsRequest.url).toBe("https://api.x.ai/v1/models");
    expect(request.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer xai-api-key",
    });
    expect(modelsRequest.headers).toEqual({ Authorization: "Bearer xai-api-key" });
  });

  test("custom providers and configured header overrides remain untouched", () => {
    const custom = provider("oauth");
    custom.headers = { "x-grok-client-version": "0.2.94", "x-custom": "kept" };

    expect(resolveProviderTransport("custom-xai", custom)).toBe(custom);
    expect(resolveProviderTransport("xai", custom).headers).toMatchObject({
      "x-grok-client-version": "0.2.94",
      "x-custom": "kept",
      "x-grok-client-identifier": "opencodex",
      "x-xai-token-auth": "xai-grok-cli",
    });
  });
});

describe("xAI prompt-cache conv-id affinity", () => {
  test("promptCacheKey derives a stable hashed x-grok-conv-id in oauth mode", () => {
    const effective = resolveProviderTransport("xai", provider("oauth"), "codex-session-abc");
    const again = resolveProviderTransport("xai", provider("oauth"), "codex-session-abc");

    expect(effective.headers?.[XAI_CONV_ID_HEADER]).toBe(deriveXaiConvId("codex-session-abc"));
    expect(effective.headers?.[XAI_CONV_ID_HEADER]).toMatch(/^[0-9a-f]{32}$/);
    // Stable across requests (cache affinity) and never the raw session id.
    expect(again.headers?.[XAI_CONV_ID_HEADER]).toBe(effective.headers?.[XAI_CONV_ID_HEADER]);
    expect(effective.headers?.[XAI_CONV_ID_HEADER]).not.toContain("codex-session-abc");
  });

  test("key mode gains conv-id affinity without touching baseUrl or CLI headers", () => {
    const configured = provider("key");
    const effective = resolveProviderTransport("xai", configured, "codex-session-abc");
    const request = createOpenAIChatAdapter(effective).buildRequest(parsed());

    expect(effective.baseUrl).toBe("https://api.x.ai/v1");
    expect(request.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(effective.headers?.[XAI_CONV_ID_HEADER]).toBe(deriveXaiConvId("codex-session-abc"));
    expect(effective.headers?.["x-grok-client-identifier"]).toBeUndefined();
    expect(effective.headers?.["x-xai-token-auth"]).toBeUndefined();
  });

  test("missing, empty, and whitespace-only cache keys never emit a conv-id", () => {
    const noKeyOauth = resolveProviderTransport("xai", provider("oauth"));
    const emptyKeyOauth = resolveProviderTransport("xai", provider("oauth"), "");
    const blankKeyOauth = resolveProviderTransport("xai", provider("oauth"), "   ");
    const configuredKey = provider("key");
    const emptyKeyApi = resolveProviderTransport("xai", configuredKey, "");

    expect(noKeyOauth.headers?.[XAI_CONV_ID_HEADER]).toBeUndefined();
    expect(emptyKeyOauth.headers?.[XAI_CONV_ID_HEADER]).toBeUndefined();
    expect(blankKeyOauth.headers?.[XAI_CONV_ID_HEADER]).toBeUndefined();
    // Key mode without a conv-id stays the exact configured object (no clone churn).
    expect(emptyKeyApi).toBe(configuredKey);
  });

  test("user-configured conv-id header wins in any casing (no duplicate header pair)", () => {
    const lower = provider("oauth");
    lower.headers = { [XAI_CONV_ID_HEADER]: "user-pinned" };
    const mixed = provider("key");
    mixed.headers = { "X-Grok-Conv-Id": "user-pinned-mixed" };

    const lowerResolved = resolveProviderTransport("xai", lower, "codex-session-abc");
    const mixedResolved = resolveProviderTransport("xai", mixed, "codex-session-abc");

    expect(lowerResolved.headers?.[XAI_CONV_ID_HEADER]).toBe("user-pinned");
    // Mixed casing: the generated lowercase header must be suppressed entirely.
    expect(mixedResolved.headers?.["X-Grok-Conv-Id"]).toBe("user-pinned-mixed");
    expect(mixedResolved.headers?.[XAI_CONV_ID_HEADER]).toBeUndefined();
    const convIdKeys = Object.keys(mixedResolved.headers ?? {}).filter(k => k.toLowerCase() === XAI_CONV_ID_HEADER);
    expect(convIdKeys).toHaveLength(1);
  });
});

describe("xAI reasoning_content cache preservation", () => {
  test("registry preset replays reasoning_content for grok reasoning models only", () => {
    const entry = getProviderRegistryEntry("xai");
    expect(entry?.preserveReasoningContentModels).toEqual([
      "grok-4.5",
      "grok-4.3",
      "grok-4.20-multi-agent-0309",
      "grok-4.20-0309-reasoning",
    ]);
    for (const noReasoning of entry?.noReasoningModels ?? []) {
      expect(entry?.preserveReasoningContentModels).not.toContain(noReasoning);
    }
  });

  test("assistant thinking parts round-trip as reasoning_content on grok-4.5 history", () => {
    // xAI docs: dropped reasoning_content is the top cause of multi-turn cache misses
    // (docs.x.ai prompt-caching/multi-turn, 2026-07-13).
    const prov: OcxProviderConfig = {
      ...provider("oauth"),
      preserveReasoningContentModels: getProviderRegistryEntry("xai")?.preserveReasoningContentModels ?? [],
    };
    const assistant: OcxAssistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "cached chain" },
        { type: "text", text: "answer" },
      ],
      timestamp: 0,
    };
    const req: OcxParsedRequest = {
      modelId: "grok-4.5",
      context: { messages: [{ role: "user", content: "q1", timestamp: 0 }, assistant, { role: "user", content: "q2", timestamp: 0 }] },
      stream: false,
      options: {},
    };
    const body = JSON.parse(createOpenAIChatAdapter(prov).buildRequest(req).body as string) as { messages: Array<Record<string, unknown>> };
    const replayed = body.messages.find(m => m.role === "assistant");
    expect(replayed?.reasoning_content).toBe("cached chain");
  });
});
