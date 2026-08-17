import { describe, expect, test } from "bun:test";
import { buildOpenAIChatPassthroughRequest } from "../src/adapters/openai-chat";
import { canSerializeServiceTierForChatModel, serviceTierSupportForModel } from "../src/providers/service-tier";
import { providerForNativeChatSerialization } from "../src/server/chat-native";
import type { OcxProviderConfig } from "../src/types";

const MODEL_ID = "grok-4";

function xaiProvider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://api.x.ai/v1",
    apiKey: "xai-test",
    authMode: "key",
    chatServiceTier: true,
    ...overrides,
  };
}

function directChatBody(provider: OcxProviderConfig): Record<string, unknown> {
  const serializationProvider = providerForNativeChatSerialization("xai", provider, MODEL_ID);
  const request = buildOpenAIChatPassthroughRequest(
    serializationProvider,
    {
      messages: [{ role: "user", content: "hello" }],
      service_tier: "priority",
    },
    MODEL_ID,
    false,
  );
  return JSON.parse(request.body) as Record<string, unknown>;
}

describe("xAI Priority Processing transport boundary", () => {
  test("canonical API-key transport is the only xAI Chat transport that advertises Fast", () => {
    const canonical = xaiProvider();
    expect(canSerializeServiceTierForChatModel(canonical, MODEL_ID, "xai")).toBe(true);
    expect(serviceTierSupportForModel(canonical, MODEL_ID, "xai")).toBe(true);

    const trailingSlash = xaiProvider({ baseUrl: "https://api.x.ai/v1/" });
    expect(canSerializeServiceTierForChatModel(trailingSlash, MODEL_ID, "xai")).toBe(true);

    for (const provider of [
      xaiProvider({ authMode: "oauth", baseUrl: "https://cli-chat-proxy.grok.com/v1" }),
      xaiProvider({ baseUrl: "https://relay.example.test/v1" }),
      xaiProvider({ baseUrl: "https://api.x.ai.evil.example/v1" }),
      xaiProvider({ baseUrl: "https://api.x.ai/v1?proxy=1" }),
    ]) {
      expect(canSerializeServiceTierForChatModel(provider, MODEL_ID, "xai")).toBe(false);
      expect(serviceTierSupportForModel(provider, MODEL_ID, "xai")).toBe(false);
    }
  });

  test("explicit provider and model opt-outs remain fail-closed on canonical xAI", () => {
    const chatOptOut = xaiProvider({ chatServiceTier: false });
    expect(canSerializeServiceTierForChatModel(chatOptOut, MODEL_ID, "xai")).toBe(false);
    expect(serviceTierSupportForModel(chatOptOut, MODEL_ID, "xai")).toBe(false);

    const providerOptOut = xaiProvider({ supportsServiceTier: false });
    expect(canSerializeServiceTierForChatModel(providerOptOut, MODEL_ID, "xai")).toBe(false);
    expect(serviceTierSupportForModel(providerOptOut, MODEL_ID, "xai")).toBe(false);

    const modelOptOut = xaiProvider({ modelSupportsServiceTier: { [MODEL_ID]: false } });
    expect(canSerializeServiceTierForChatModel(modelOptOut, MODEL_ID, "xai")).toBe(false);
    expect(serviceTierSupportForModel(modelOptOut, MODEL_ID, "xai")).toBe(false);
  });

  test("native Chat serialization consumes the same transport-aware decision", () => {
    expect(directChatBody(xaiProvider()).service_tier).toBe("priority");

    for (const provider of [
      xaiProvider({ authMode: "oauth", baseUrl: "https://cli-chat-proxy.grok.com/v1" }),
      xaiProvider({ baseUrl: "https://relay.example.test/v1" }),
      xaiProvider({ chatServiceTier: false }),
      xaiProvider({ supportsServiceTier: false }),
      xaiProvider({ modelSupportsServiceTier: { [MODEL_ID]: false } }),
    ]) {
      expect(directChatBody(provider)).not.toHaveProperty("service_tier");
    }
  });
});
